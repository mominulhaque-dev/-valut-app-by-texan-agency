import QRCode from "qrcode";

/**
 * QR settings for a small engraved metal disc:
 * - error correction M: H would add modules and make the pattern denser
 * - 4-module quiet zone, as the QR spec requires
 * - pure black on white
 */
const ERROR_CORRECTION = "M" as const;
const QUIET_ZONE = 4;
const PNG_MIN_WIDTH = 1024;

export type QrFormat = "png" | "svg";

function matrix(text: string): { size: number; isDark: (x: number, y: number) => boolean } {
  const { modules } = QRCode.create(text, {
    errorCorrectionLevel: ERROR_CORRECTION,
  });
  return {
    size: modules.size,
    isDark: (x, y) => modules.data[y * modules.size + x] === 1,
  };
}

/**
 * Vector output for engraving and print: one path of axis-aligned rectangles,
 * no raster, no fonts, no transforms. Horizontal runs of dark modules are
 * merged so the engraver gets fewer, cleaner shapes.
 */
export function renderQrSvg(text: string): string {
  const { size, isDark } = matrix(text);
  const total = size + QUIET_ZONE * 2;
  let path = "";
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!isDark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && isDark(x, y)) x++;
      path += `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${total}mm" height="${total}mm" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>\n`
  );
}

/** Raster output for admin preview and proofs only. Never sent to the engraver. */
export async function renderQrPng(text: string): Promise<Buffer> {
  const { size } = matrix(text);
  // Whole pixels per module, so module edges stay sharp.
  const scale = Math.ceil(PNG_MIN_WIDTH / (size + QUIET_ZONE * 2));
  return QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: QUIET_ZONE,
    scale,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}
