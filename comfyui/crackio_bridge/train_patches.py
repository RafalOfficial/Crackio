"""
Training forms of model code that ComfyUI wrote for inference only (bridge 1.11, with train.py).

Some of ComfyUI's models add each block's result into the tensor the block was given (`x[:, a:b].addcmul_(…)`,
`img += …`) and build sequences with `torch.cat(…, out=x)`: forms that save memory while drawing, and that PyTorch can't
differentiate through. Trained as they are, FLUX 3 stops at the first step, and FLUX.1, FLUX.2 and Qwen-Image 2.1 either
stop or, with gradient checkpointing on, go on with gradients that are wrong (ComfyUI issues #17076 and #16653, Oct 2026).

`apply(model)` gives the model's blocks the same maths written out of place for the length of a training job and returns
what puts the originals back. train.py then checks two things before the first step: that the patched model answers
like the untouched one, and that its gradients with and without checkpointing agree.

Covered: FLUX 3 (comfy/ldm/flux3). Qwen-Image 2.1 (comfy/ldm/qwen_image21), whose drawing code also keeps what the
words and reference pictures give each block from one step to the next: off while training. FLUX.1, FLUX.2 and Chroma
(comfy/ldm/flux): their `+=` residuals are made out of place by handing the blocks tensors whose `+=` returns a new
tensor. Models whose code is already fine (Z-Image, the first Qwen-Image, Krea 2, SDXL, SD 1.5…) are left as they are.
"""
import sys
import types

import torch

import comfy.ops
import comfy.utils

# While this is on, every stand-in below runs ComfyUI's own code instead (train.py compares the two before a run).
ORIGINAL = {"on": False}


def _mod(obj):
    return sys.modules[type(obj).__module__]


# ------------------------------------------------------------------ FLUX 3


def _flux3_block(self, x, spans, pe, transformer_options={}):
    """comfy.ldm.flux3.model.Block.forward, with the modulated rows and the gated residual built out of place."""
    if ORIGINAL["on"]:
        return type(self).forward(self, x, spans, pe, transformer_options)
    f3 = _mod(self)
    B, N, _ = x.shape
    tiles = spans[0][0] == 0 and spans[-1][1] == N and all(spans[i][0] == spans[i - 1][1] for i in range(1, len(spans)))
    if len(spans) == 1 and tiles:
        x_mod = f3.modulated_norm(x, self.pre_norm, spans[0][2].scale, spans[0][2].shift)
    elif tiles:
        x_mod = torch.cat([f3.modulated_norm(x[:, s:e], self.pre_norm, m.scale, m.shift) for s, e, m in spans], dim=1)
    else:
        # As the original does it: the first span's modulation on every row, the others redo their rows (on a copy).
        x_mod = f3.modulated_norm(x, self.pre_norm, spans[0][2].scale, spans[0][2].shift).clone()
        for s, e, m in spans[1:]:
            x_mod[:, s:e] = f3.modulated_norm(x[:, s:e], self.pre_norm, m.scale, m.shift)

    if self.fused_qkv:
        q, k, v = self.qkv(x_mod).chunk(3, dim=-1)
    else:
        q, k, v = self.q_proj(x_mod), self.k_proj(x_mod), self.v_proj(x_mod)
    mlp = self.mlp_in(x_mod)
    del x_mod
    q, k = self.norm(q.view(B, N, self.num_heads, -1), k.view(B, N, self.num_heads, -1), pe)
    q, k, v = f3.AttentionTensorContainer(q.flatten(2)), f3.AttentionTensorContainer(k.flatten(2)), f3.AttentionTensorContainer(v)
    out = self.attn_out(f3.optimized_attention(q, k, v, self.num_heads, transformer_options=transformer_options, preferred_attention=self.comfy_attention))
    out = comfy.ops.linear_input_act(self.mlp_out, mlp, "swiglu", residual=out, residual_scale=out.new_ones(out.shape[-1]))
    del mlp
    if tiles:
        return x + torch.cat([out[:, s:e] * m.gate for s, e, m in spans], dim=1)
    x = x.clone()
    for s, e, m in spans:
        x[:, s:e] = x[:, s:e] + out[:, s:e] * m.gate
    return x


def _flux3_preprocess(self, context, ref_latents=None, vec_target=None, transformer_options={}):
    """Flux3.preprocess_conds: the early blocks of the text (and references) alone, each block's result kept."""
    if ORIGINAL["on"]:
        return type(self).preprocess_conds(self, context, ref_latents, vec_target, transformer_options)
    f3 = _mod(self)
    device = context.device
    if ref_latents:
        batch = max([context.shape[0]] + [ref.shape[0] for ref in ref_latents])
        context = comfy.utils.repeat_to_batch_size(context, batch)
        ref_latents = [comfy.utils.repeat_to_batch_size(ref, batch) for ref in ref_latents]
    vec = self.time_in(f3.timestep_embedding(context.new_zeros(1), 256))
    if vec_target is not None:
        vec = vec + vec_target
    streams = [(self.txt_in(context), "txt", None, self.txt_mode_blocks)]
    if ref_latents:
        refs = self.emb_in["image_cond"](torch.cat([ref.flatten(2).transpose(1, 2) for ref in ref_latents], dim=1))
        streams.append((refs, "image_cond", [ref.shape[-2:] for ref in ref_latents], self.content_mode_blocks["image_cond"]))
    done = []
    for tokens, mode, shapes, blocks in streams:
        ids = self.text_ids(tokens.shape[1], device) if mode == "txt" else self.ref_ids(shapes, device)
        mod = self.early_stream_modulations[mode](vec)[0]
        pe = self.rope(ids)
        for block in blocks:
            tokens = block(tokens, [(0, tokens.shape[1], mod)], pe, transformer_options)
        done.append(tokens)
    return done[0], (done[1] if len(done) > 1 else None)


def _flux3_forward(self, x, timestep, context=None, ref_latents=None, transformer_options={}, txt_states=None, ref_states=None, ref_shapes=None, **kwargs):
    """Flux3._forward: the joint sequence made with a plain `cat`, no memory-compiler regions."""
    if ORIGINAL["on"]:
        return type(self)._forward(self, x, timestep, context, ref_latents, transformer_options, txt_states, ref_states, ref_shapes, **kwargs)
    f3 = _mod(self)
    B, _, H, W = x.shape
    dtype, device = x.dtype, x.device
    if self.flow_map:
        raise RuntimeError("a step-distilled FLUX 3 file can't be trained on")
    if txt_states is None:
        txt_states, ref_states = self.preprocess_conds(context, ref_latents, None, transformer_options)
        ref_shapes = [ref.shape[-2:] for ref in ref_latents] if ref_latents else None
    transformer_options = transformer_options.copy()

    vec = self.time_in(f3.timestep_embedding(torch.cat([timestep, timestep.new_zeros(1)]).to(dtype), 256))
    vec_img, vec_zero = vec[:-1], vec[-1:]
    early = self.early_stream_modulations["image"](vec_img)[0]

    img = self.emb_in["image"](x.flatten(2).transpose(1, 2))
    parts = [(img, "image", self.image_ids(H, W, 0, device))]
    if ref_states is not None:
        parts.append((ref_states, "image_cond", self.ref_ids(ref_shapes, device)))
    parts.append((txt_states, "txt", self.text_ids(txt_states.shape[1], device)))
    pe = self.rope(torch.cat([ids for _, _, ids in parts]))
    spans, start = [], 0
    for tokens, mode, _ in parts:
        spans.append((start, start + tokens.shape[1], self.single_stream_modulations[mode](vec_img if mode == "image" else vec_zero)[0]))
        start += tokens.shape[1]

    for block in self.content_mode_blocks["image"]:
        img = block(img, [(0, H * W, early)], pe[:, : H * W], transformer_options)
    x = torch.cat([img] + [tokens for tokens, _, _ in parts[1:]], dim=1)
    del img, parts
    transformer_options["total_blocks"] = len(self.single_blocks)
    transformer_options["block_type"] = "single"
    for i, block in enumerate(self.single_blocks):
        transformer_options["block_index"] = i
        x = block(x, spans, pe, transformer_options)
    out = self.final_layer["image"](x[:, : H * W], vec_img)
    return out.transpose(1, 2).reshape(B, self.in_channels, H, W)


def _apply_flux3(model):
    f3 = _mod(model)
    blocks = [m for m in model.modules() if isinstance(m, f3.Block)]
    # The code these stand in for: if ComfyUI reshapes it, say so instead of training on a guess.
    for name in ("content_mode_blocks", "txt_mode_blocks", "single_blocks", "early_stream_modulations", "single_stream_modulations", "emb_in", "txt_in", "time_in", "final_layer", "rope", "image_ids", "text_ids"):
        if not hasattr(model, name):
            raise RuntimeError(f"ComfyUI's FLUX 3 code has changed ({name} is gone): Crackio's trainer needs an update for it")
    done = []
    for b in blocks:
        for name in ("pre_norm", "mlp_in", "mlp_out", "attn_out", "norm", "comfy_attention"):
            if not hasattr(b, name):
                raise RuntimeError(f"ComfyUI's FLUX 3 code has changed (a block's {name} is gone): Crackio's trainer needs an update for it")
        b.forward = types.MethodType(_flux3_block, b)
        done.append((b, "forward"))
    model._forward = types.MethodType(_flux3_forward, model)
    model.preprocess_conds = types.MethodType(_flux3_preprocess, model)
    done += [(model, "_forward"), (model, "preprocess_conds")]
    return done


# ------------------------------------------------------------------ FLUX.1, FLUX.2, Chroma: `+=` on the block's input


class _OutOfPlace(torch.Tensor):
    """A tensor whose `+=` makes a new tensor (Python rebinds the name to what __iadd__ returns), so a block written
    `img += …` leaves the tensor it was given alone. What's computed from it is one of these too."""

    def __iadd__(self, other):
        return torch.Tensor.add(self, other)


def _fresh(v):
    return v.as_subclass(_OutOfPlace) if isinstance(v, torch.Tensor) and type(v) is torch.Tensor else v


def _plain(v):
    if isinstance(v, _OutOfPlace):
        return v.as_subclass(torch.Tensor)
    if isinstance(v, tuple):
        return tuple(_plain(x) for x in v)
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def _wrap_iadd(block):
    orig = block.forward

    def forward(*args, **kwargs):
        if ORIGINAL["on"]:
            return orig(*args, **kwargs)
        args = tuple(_fresh(a) for a in args)
        kwargs = {k: (_fresh(v) if k in ("img", "txt", "x") else v) for k, v in kwargs.items()}
        return _plain(orig(*args, **kwargs))

    block.forward = forward
    return (block, "forward")


def _apply_flux(model):
    layers = sys.modules.get("comfy.ldm.flux.layers")
    kinds = tuple(k for k in (getattr(layers, "DoubleStreamBlock", None), getattr(layers, "SingleStreamBlock", None)) if k is not None)
    return [_wrap_iadd(m) for m in model.modules() if kinds and isinstance(m, kinds)]


# ------------------------------------------------------------------ Qwen-Image 2.1


def _qwen21_block(self, x, mod, pe, attn_fn, prefix_len, transformer_options={}):
    """comfy.ldm.qwen_image21.model.QwenImage21TransformerBlock.forward, with the gated residual added out of place
    (ComfyUI's `_gated_residual` writes each block's result into the tensor the block was given)."""
    if ORIGINAL["on"]:
        return type(self).forward(self, x, mod, pe, attn_fn, prefix_len, transformer_options)
    q21 = _mod(self)
    scale1, gate1, scale2, gate2, zero = mod

    def gated(x, y, gate):
        g_prefix, g_target = gate
        if prefix_len:
            return x + torch.cat([y[:, :prefix_len] * g_prefix, y[:, prefix_len:] * g_target], dim=1)
        return x + y * g_target

    def normed(norm, scale):
        # Under autocast a LayerNorm answers in 32-bit floats, and ComfyUI's layers then make a 32-bit copy of their
        # weight to match what comes in: twice the model's size held for the way back (a 24 GB card ran out). Back in
        # the stream's own format, the weights are used as they are.
        return q21._modulated_norm(norm, x, scale, prefix_len, zero).to(x.dtype)

    x = gated(x, self.attn(normed(self.img_norm1, scale1), pe, attn_fn, prefix_len, transformer_options), gate1)
    x = gated(x, self.img_mlp(normed(self.img_norm2, scale2)), gate2)
    if x.dtype == torch.float16:
        x = x.clamp(-65504, 65504)
    return x


def _qwen21_forward(self, x, timesteps, context, ref_latents=None, image_slots=None, transformer_options={}, prefix_cache=None, **kwargs):
    """QwenImage21Transformer2DModel._forward: the whole sequence (words, the pictures to change, the picture being
    made) through every block at every step. ComfyUI keeps what the words and reference pictures give each block from
    one step to the next while it draws; in training those change with the LoRA at every step and must be learned
    through, so nothing is kept here, and there are no memory-compiler regions."""
    if ORIGINAL["on"]:
        return type(self)._forward(self, x, timesteps, context, ref_latents, image_slots, transformer_options, prefix_cache=None, **kwargs)
    q21 = _mod(self)
    B, _, H, W = x.shape
    dtype = x.dtype
    hidden, pe, segments = self.build_sequence(x, context, list(ref_latents or []), list(image_slots or []))
    prefix_len = hidden.shape[1] - H * W

    t = ((timesteps * 1000).to(dtype) / 1000).to(dtype)
    temb = self.time_text_embed(torch.cat([t, t.new_zeros(1)]), dtype)
    scale1, gate1, scale2, gate2 = self.modulation(temb).chunk(4, dim=-1)
    mod = (q21._split_rows(scale1), q21._split_rows(gate1.tanh()), q21._split_rows(scale2), q21._split_rows(gate2.tanh()), torch.zeros_like(scale1[:1, None]))

    transformer_options = transformer_options.copy()
    transformer_options["total_blocks"] = len(self.transformer_blocks)
    transformer_options["block_type"] = "single"
    attn_fn = q21.block_causal_attention(segments, transformer_options, None, 0, prefix_len)
    for i, block in enumerate(self.transformer_blocks):
        transformer_options["block_index"] = i
        hidden = block(hidden, mod, pe, attn_fn, prefix_len, transformer_options)
    hidden = self.proj_out(self.norm_out(hidden[:, prefix_len:], temb[:-1]))
    return hidden.transpose(1, 2).reshape(B, self.out_channels, H, W)


def _apply_qwen21(model):
    q21 = _mod(model)
    for name in ("transformer_blocks", "build_sequence", "time_text_embed", "modulation", "norm_out", "proj_out", "can_cache_prefix"):
        if not hasattr(model, name):
            raise RuntimeError(f"ComfyUI's Qwen-Image 2.1 code has changed ({name} is gone): Crackio's trainer needs an update for it")
    for name in ("_modulated_norm", "_split_rows", "block_causal_attention", "QwenImage21TransformerBlock"):
        if not hasattr(q21, name):
            raise RuntimeError(f"ComfyUI's Qwen-Image 2.1 code has changed ({name} is gone): Crackio's trainer needs an update for it")
    done = []
    for b in model.modules():
        if isinstance(b, q21.QwenImage21TransformerBlock):
            for name in ("img_norm1", "img_norm2", "attn", "img_mlp"):
                if not hasattr(b, name):
                    raise RuntimeError(f"ComfyUI's Qwen-Image 2.1 code has changed (a block's {name} is gone): Crackio's trainer needs an update for it")
            b.forward = types.MethodType(_qwen21_block, b)
            done.append((b, "forward"))
    model._forward = types.MethodType(_qwen21_forward, model)
    # Off for ComfyUI's own code too (the check before the first step runs it): what's kept would come from another step.
    model.can_cache_prefix = lambda transformer_options={}: False
    done += [(model, "_forward"), (model, "can_cache_prefix")]
    return done


# ------------------------------------------------------------------


def family(model):
    """Which training form a diffusion model needs: "flux3", "qwen21", "flux", or None when its own code trains as it is."""
    module = type(model).__module__
    if module.startswith("comfy.ldm.flux3"):
        return "flux3"
    if module.startswith("comfy.ldm.qwen_image21"):
        return "qwen21"
    layers = sys.modules.get("comfy.ldm.flux.layers")
    if layers is not None:
        kinds = tuple(k for k in (getattr(layers, "DoubleStreamBlock", None), getattr(layers, "SingleStreamBlock", None)) if k is not None)
        if kinds and any(isinstance(m, kinds) for m in model.modules()):
            return "flux"
    return None


def apply(model):
    """Give `model` its training forms. Returns (family or None, undo)."""
    which = family(model)
    done = _apply_flux3(model) if which == "flux3" else _apply_qwen21(model) if which == "qwen21" else _apply_flux(model) if which == "flux" else []

    def undo():
        for obj, name in reversed(done):
            try:
                delattr(obj, name)  # the instance's stand-in goes; the class's own method is there again
            except AttributeError:
                pass
        done.clear()

    return which, undo
