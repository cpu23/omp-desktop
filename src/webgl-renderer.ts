const SOFTWARE_RENDERER = /\b(?:swiftshader|llvmpipe|softpipe|lavapipe)\b|software\s+rasterizer/i;

type DebugRendererInfo = {
  UNMASKED_VENDOR_WEBGL: number;
  UNMASKED_RENDERER_WEBGL: number;
};
type LoseContextExtension = { loseContext(): void };

/** Only debug names of known software rasterizers select the DOM fallback. */
export function isKnownSoftwareWebglRenderer(vendor: unknown, renderer: unknown): boolean {
  return (typeof vendor === "string" && SOFTWARE_RENDERER.test(vendor)) ||
    (typeof renderer === "string" && SOFTWARE_RENDERER.test(renderer));
}

let softwareRenderer: boolean | undefined;

/** Probe once per window and explicitly release the temporary WebGL context. */
export function shouldUseDomFallbackForSoftwareWebgl(): boolean {
  if (softwareRenderer !== undefined) return softwareRenderer;

  let detected = false;
  let canvas: HTMLCanvasElement | undefined;
  let gl: WebGL2RenderingContext | null = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    // The optional debug extension's constants are not exposed in DOM typings.
    gl = canvas.getContext("webgl2", { antialias: false, depth: false });
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as DebugRendererInfo | null;
      if (debugInfo) {
        detected = isKnownSoftwareWebglRenderer(
          gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
          gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
        );
      }
    }
  } catch {
    // Missing, blocked, or failing debug info is not evidence of software rendering.
  } finally {
    if (gl) {
      try {
        const loseContext = gl.getExtension("WEBGL_lose_context") as LoseContextExtension | null;
        loseContext?.loseContext();
      } catch {
        // Removing the canvas below still releases the probe's references.
      }
    }
    canvas?.remove();
  }

  softwareRenderer = detected;
  return detected;
}
