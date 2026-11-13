import { wireSessionHover } from "../../src/session-hover";
(globalThis as unknown as { wireSessionHover: typeof wireSessionHover }).wireSessionHover = wireSessionHover;
