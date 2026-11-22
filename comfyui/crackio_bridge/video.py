"""
Crackio nodes for the Director's video re-shoot (a video seen from a new camera, the way the Crackio challenge's winner
re-shoots one: MoGe-3 measures every frame, Panorama Stickers' Studio renders them from the new camera path, a video
model draws the finished shot over that render). Only ComfyUI's own code underneath; no new packages.

Crackio IC-LoRA Guide: Lightricks' "Add Video IC-LoRA Guide" (ComfyUI-LTXVideo `LTXAddVideoICLoRAGuide`, Apache-2.0),
the whole-clip path, without the rest of that pack. A video reference goes in at frame 0 (it lines up with the clip);
a single picture at -1 sits just before the clip, so it is seen as the look to keep, never as the first frame to copy
(core LTXVAddGuide reads -1 as the last frame). LTX-2.5's Layout to Render IC-LoRA takes its clay video at 0 and the
look still at -1, at strength 1: the same encode, keyframe and attention entry as theirs.

Crackio MoGe Clay: MoGe's geometry with its picture swapped for gray clay lit from above (its normals, a fixed light
in the camera's frame), so the Studio renders a clay viewport of the footage from the new camera: what Layout to
Render was trained on (a Blender or Unreal clay playblast).
"""
import comfy.utils
import torch
import torch.nn.functional as F

import comfy_extras.nodes_lt as nodes_lt


class CrackioICLoRAGuide:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE",),
                "latent": ("LATENT",),
                "image": ("IMAGE",),
                "frame_idx": ("INT", {"default": 0, "min": -9999, "max": 9999, "tooltip": "0: a video lined up with the clip. -1: a single picture just before the clip (the look). Above 0: a picture at that frame."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "crop": (["disabled", "center"], {"default": "disabled", "tooltip": "disabled stretches to the clip's size, center crops to it."}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "guide"
    CATEGORY = "Crackio"

    def guide(self, positive, negative, vae, latent, image, frame_idx, strength, crop):
        scale_factors = vae.downscale_index_formula
        latent_image = latent["samples"]
        noise_mask = nodes_lt.get_noise_mask(latent)
        _, _, latent_length, latent_height, latent_width = latent_image.shape
        time_scale, width_scale, height_scale = scale_factors

        keep = ((image.shape[0] - 1) // time_scale) * time_scale + 1
        causal_fix = frame_idx == 0 or keep == 1
        if not causal_fix:
            # A clip placed past frame 0: a throwaway first frame takes the VAE's one-pixel-frame first latent.
            image = torch.cat([image[:1], image], dim=0)
        images = image[: ((image.shape[0] - 1) // time_scale) * time_scale + 1]
        pixels = comfy.utils.common_upscale(images.movedim(-1, 1), int(latent_width * width_scale), int(latent_height * height_scale), "bilinear", crop=crop).movedim(1, -1)[:, :, :, :3]
        guide_latent = vae.encode(pixels)
        if not causal_fix:
            guide_latent = guide_latent[:, :, 1:, :, :]
            pixels = pixels[1:]

        shape = list(guide_latent.shape[2:])
        tokens = shape[0] * shape[1] * shape[2]
        if frame_idx >= 0:
            frame_idx, latent_idx = nodes_lt.LTXVAddGuide.get_latent_index(positive, latent_length, len(pixels), frame_idx, scale_factors)
            if latent_idx + guide_latent.shape[2] > latent_length:
                raise ValueError("Conditioning frames exceed the length of the latent sequence.")
        # Below 0 it is a position before the clip, kept as it is.
        positive, negative, latent_image, noise_mask = nodes_lt.LTXVAddGuide.append_keyframe(
            positive, negative, frame_idx, latent_image, noise_mask, guide_latent, strength, scale_factors, guide_mask=None, latent_downscale_factor=1, causal_fix=causal_fix
        )
        positive, negative = nodes_lt._append_guide_attention_entry(positive, negative, tokens, shape, strength=1.0)
        return (positive, negative, {"samples": latent_image, "noise_mask": noise_mask})


def _normals(points: torch.Tensor) -> torch.Tensor:
    """Camera-space normals from a (B, H, W, 3) point map, facing out: core MoGe's own fallback, or the same maths."""
    try:
        from comfy_extras.nodes_moge import _normals_from_points

        return _normals_from_points(points)
    except ImportError:
        finite = torch.isfinite(points).all(dim=-1, keepdim=True)
        pts = torch.where(finite, points, torch.zeros_like(points))
        dx = F.pad((pts[:, :, 2:] - pts[:, :, :-2]).permute(0, 3, 1, 2), (1, 1, 0, 0)).permute(0, 2, 3, 1)
        dy = F.pad((pts[:, 2:] - pts[:, :-2]).permute(0, 3, 1, 2), (0, 0, 1, 1)).permute(0, 2, 3, 1)
        n = F.normalize(torch.cross(dy, dx, dim=-1), dim=-1)
        return torch.where(finite, n, torch.zeros_like(n))


class CrackioMoGeClay:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "moge_geometry": ("MOGE_GEOMETRY",),
                "gray": ("FLOAT", {"default": 0.62, "min": 0.05, "max": 1.0, "step": 0.01, "tooltip": "How light the clay is where the light falls fully."}),
                "ambient": ("FLOAT", {"default": 0.32, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Light on surfaces turned away from it, as a share of the full light."}),
            }
        }

    RETURN_TYPES = ("MOGE_GEOMETRY",)
    RETURN_NAMES = ("moge_geometry",)
    FUNCTION = "clay"
    CATEGORY = "Crackio"

    def clay(self, moge_geometry, gray, ambient):
        image = moge_geometry["image"]
        normal = moge_geometry.get("normal")
        if normal is None:
            points = moge_geometry.get("points")
            if points is None:
                raise ValueError("This MoGe geometry has neither normals nor points to light the clay with.")
            normal = _normals(points.float())
        normal = F.normalize(normal.float().cpu(), dim=-1)
        # OpenCV camera axes (x right, y down, z ahead): from above, a little left, toward the camera.
        light = F.normalize(torch.tensor([-0.35, -0.75, -0.55]), dim=0)
        lit = (normal * light).sum(-1).clamp(min=0.0)
        shade = (gray * (ambient + (1.0 - ambient) * lit)).clamp(0.0, 1.0)
        if shade.shape[1:3] != image.shape[1:3]:
            shade = F.interpolate(shade[:, None], size=image.shape[1:3], mode="bilinear", align_corners=False)[:, 0]
        clay = shade[..., None].expand(-1, -1, -1, 3).contiguous().to(image.dtype)
        return ({**moge_geometry, "image": clay},)


NODE_CLASS_MAPPINGS = {"CrackioICLoRAGuide": CrackioICLoRAGuide, "CrackioMoGeClay": CrackioMoGeClay}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioICLoRAGuide": "Crackio IC-LoRA Guide", "CrackioMoGeClay": "Crackio MoGe Clay"}
