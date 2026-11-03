import { lanCaPem } from "@/lib/server/lan-https";

/**
 * The certificate of Crackio's own little authority, to trust on a Mac or phone so the secure network address opens
 * without a warning. It can only vouch for local names and private addresses.
 */
export async function GET() {
  const pem = await lanCaPem();
  if (!pem) return Response.json({ error: "Crackio hasn't made its certificate yet. Restart Crackio and try again." }, { status: 404 });
  return new Response(pem, {
    headers: {
      "Content-Type": "application/x-x509-ca-cert",
      "Content-Disposition": 'attachment; filename="Crackio-local-CA.crt"',
      "Cache-Control": "no-store",
    },
  });
}
