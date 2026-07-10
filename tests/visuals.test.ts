import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  renderSyntheticDashboard,
  renderSyntheticPanel,
  SyntheticRenderError,
} from "../src/visuals/index.js";

function decode(data: string): PNG {
  return PNG.sync.read(Buffer.from(data, "base64"));
}

function hasMultipleColors(image: PNG): boolean {
  const firstPixel = image.data.subarray(0, 4);
  for (let index = 4; index < image.data.length; index += 4) {
    if (
      image.data[index] !== firstPixel[0] ||
      image.data[index + 1] !== firstPixel[1] ||
      image.data[index + 2] !== firstPixel[2] ||
      image.data[index + 3] !== firstPixel[3]
    ) {
      return true;
    }
  }
  return false;
}

describe("synthetic visual rendering", () => {
  it("renders a deterministic, nonblank panel PNG with integrity metadata", () => {
    const input = { width: 320, height: 180, maxBytes: 200_000 };
    const first = renderSyntheticPanel(input);
    const second = renderSyntheticPanel(input);
    const bytes = Buffer.from(first.data, "base64");
    const image = decode(first.data);

    expect(first.mimeType).toBe("image/png");
    expect(first.width).toBe(input.width);
    expect(first.height).toBe(input.height);
    expect(image.width).toBe(input.width);
    expect(image.height).toBe(input.height);
    expect(hasMultipleColors(image)).toBe(true);
    expect(first.data).toBe(second.data);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(first.byteSize).toBe(bytes.byteLength);
    expect(first.renderDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("composes multiple nonblank synthetic panels into a dashboard PNG", () => {
    const input = { width: 480, height: 300, maxBytes: 300_000, panelCount: 6 };
    const result = renderSyntheticDashboard(input);
    const image = decode(result.data);

    expect(image.width).toBe(input.width);
    expect(image.height).toBe(input.height);
    expect(hasMultipleColors(image)).toBe(true);
    expect(result.byteSize).toBeLessThanOrEqual(input.maxBytes);
    expect(result.sha256).toBe(createHash("sha256").update(Buffer.from(result.data, "base64")).digest("hex"));
  });

  it("rejects invalid dimensions and output byte limits with typed errors", () => {
    expect(() => renderSyntheticPanel({ width: 0, height: 120, maxBytes: 20_000 })).toThrow(
      SyntheticRenderError,
    );
    expect(() => renderSyntheticPanel({ width: 120, height: 120, maxBytes: 0 })).toThrow(
      SyntheticRenderError,
    );
    expect(() => renderSyntheticPanel({ width: 120, height: 120, maxBytes: 1 })).toThrow(
      SyntheticRenderError,
    );
    expect(() => renderSyntheticDashboard({ width: 120, height: 120, maxBytes: 20_000, panelCount: 1 })).toThrow(
      SyntheticRenderError,
    );
  });
});
