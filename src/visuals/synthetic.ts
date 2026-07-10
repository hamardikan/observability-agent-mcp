import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PNG } from "pngjs";

const MIN_DIMENSION = 32;
const MAX_DIMENSION = 4_000;
const MAX_PIXELS = 9_600_000;
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_PANEL_COUNT = 4;
const MAX_PANEL_COUNT = 9;

export type SyntheticRenderErrorCode =
  | "invalid_dimensions"
  | "invalid_byte_limit"
  | "invalid_panel_count"
  | "visual_too_large";

export class SyntheticRenderError extends Error {
  public readonly code: SyntheticRenderErrorCode;

  public constructor(code: SyntheticRenderErrorCode, message: string) {
    super(message);
    this.name = "SyntheticRenderError";
    this.code = code;
  }
}

export interface SyntheticRenderInput {
  readonly width: number;
  readonly height: number;
  readonly maxBytes: number;
}

export interface SyntheticPanelInput extends SyntheticRenderInput {
  readonly values?: readonly number[];
}

export interface SyntheticDashboardInput extends SyntheticRenderInput {
  readonly panelCount?: number;
}

export interface SyntheticRenderResult {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly renderDurationMs: number;
}

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const PANEL_COLORS: readonly RgbColor[] = [
  { red: 28, green: 199, blue: 185 },
  { red: 89, green: 157, blue: 246 },
  { red: 250, green: 180, blue: 65 },
  { red: 235, green: 109, blue: 154 },
  { red: 151, green: 213, blue: 83 },
];

const DEFAULT_VALUES = [
  0.26, 0.35, 0.32, 0.49, 0.42, 0.58, 0.53, 0.72, 0.66, 0.78, 0.69, 0.86,
] as const;

export function renderSyntheticPanel(input: SyntheticPanelInput): SyntheticRenderResult {
  const startedAt = performance.now();
  validateRenderInput(input);

  const image = createCanvas(input.width, input.height);
  drawPanel(image, 0, 0, input.width, input.height, input.values ?? DEFAULT_VALUES, PANEL_COLORS[0]!);

  return encodeResult(image, input.maxBytes, startedAt);
}

export function renderSyntheticDashboard(
  input: SyntheticDashboardInput,
): SyntheticRenderResult {
  const startedAt = performance.now();
  validateRenderInput(input);

  const panelCount = input.panelCount ?? DEFAULT_PANEL_COUNT;
  if (!Number.isInteger(panelCount) || panelCount < 2 || panelCount > MAX_PANEL_COUNT) {
    throw new SyntheticRenderError(
      "invalid_panel_count",
      "Synthetic dashboards require a bounded panel count of at least two.",
    );
  }

  const image = createCanvas(input.width, input.height);
  const columns = Math.ceil(Math.sqrt(panelCount));
  const rows = Math.ceil(panelCount / columns);
  const gap = Math.max(2, Math.floor(Math.min(input.width, input.height) / 48));
  const panelWidth = Math.floor((input.width - gap * (columns + 1)) / columns);
  const panelHeight = Math.floor((input.height - gap * (rows + 1)) / rows);

  for (let index = 0; index < panelCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = gap + column * (panelWidth + gap);
    const y = gap + row * (panelHeight + gap);
    drawPanel(
      image,
      x,
      y,
      panelWidth,
      panelHeight,
      shiftedValues(index),
      PANEL_COLORS[index % PANEL_COLORS.length]!,
    );
  }

  return encodeResult(image, input.maxBytes, startedAt);
}

function validateRenderInput(input: SyntheticRenderInput): void {
  const { width, height, maxBytes } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_DIMENSION ||
    height < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new SyntheticRenderError(
      "invalid_dimensions",
      "Synthetic visual dimensions are outside the permitted bounds.",
    );
  }

  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES) {
    throw new SyntheticRenderError(
      "invalid_byte_limit",
      "Synthetic visual byte limit is outside the permitted bounds.",
    );
  }
}

function createCanvas(width: number, height: number): PNG {
  const image = new PNG({ width, height });
  fill(image, 16, 24, 40);
  return image;
}

function drawPanel(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  values: readonly number[],
  color: RgbColor,
): void {
  const right = x + width - 1;
  const bottom = y + height - 1;
  fillRect(image, x, y, width, height, 25, 36, 57);
  strokeRect(image, x, y, width, height, 57, 78, 108);

  const inset = Math.max(3, Math.floor(Math.min(width, height) / 10));
  const graphLeft = x + inset;
  const graphRight = Math.max(graphLeft, right - inset);
  const graphTop = y + inset + 4;
  const graphBottom = Math.max(graphTop, bottom - inset);

  for (let line = 1; line < 4; line += 1) {
    const gridY = graphTop + Math.floor(((graphBottom - graphTop) * line) / 4);
    drawLine(image, graphLeft, gridY, graphRight, gridY, 49, 68, 94);
  }
  drawLine(image, graphLeft, graphBottom, graphRight, graphBottom, 76, 97, 126);

  const normalized = normalizeValues(values);
  const spanX = Math.max(1, graphRight - graphLeft);
  const spanY = Math.max(1, graphBottom - graphTop);
  for (let index = 1; index < normalized.length; index += 1) {
    const previousX = graphLeft + Math.round((spanX * (index - 1)) / (normalized.length - 1));
    const previousY = graphBottom - Math.round(spanY * normalized[index - 1]!);
    const nextX = graphLeft + Math.round((spanX * index) / (normalized.length - 1));
    const nextY = graphBottom - Math.round(spanY * normalized[index]!);
    drawLine(image, previousX, previousY, nextX, nextY, color.red, color.green, color.blue);
    drawLine(image, previousX, previousY + 1, nextX, nextY + 1, color.red, color.green, color.blue);
  }

  fillRect(image, graphLeft, y + Math.max(2, Math.floor(inset / 2)), Math.max(4, Math.floor(width / 4)), 2, color.red, color.green, color.blue);
}

function normalizeValues(values: readonly number[]): readonly number[] {
  const usableValues = values.length >= 2 && values.every(Number.isFinite) ? values : DEFAULT_VALUES;
  const minimum = Math.min(...usableValues);
  const maximum = Math.max(...usableValues);
  const range = maximum - minimum;

  if (range === 0) {
    return usableValues.map(() => 0.5);
  }

  return usableValues.map((value) => (value - minimum) / range);
}

function shiftedValues(offset: number): readonly number[] {
  return DEFAULT_VALUES.map((value, index) => {
    const wave = ((index + offset * 3) % 5) * 0.035;
    return value + wave - offset * 0.01;
  });
}

function encodeResult(image: PNG, maxBytes: number, startedAt: number): SyntheticRenderResult {
  const bytes = PNG.sync.write(image, { colorType: 6, inputHasAlpha: true });
  if (bytes.byteLength > maxBytes) {
    throw new SyntheticRenderError(
      "visual_too_large",
      "Synthetic visual exceeds the configured output byte limit.",
    );
  }

  return {
    mimeType: "image/png",
    data: bytes.toString("base64"),
    width: image.width,
    height: image.height,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    renderDurationMs: performance.now() - startedAt,
  };
}

function fill(image: PNG, red: number, green: number, blue: number): void {
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = red;
    image.data[index + 1] = green;
    image.data[index + 2] = blue;
    image.data[index + 3] = 255;
  }
}

function fillRect(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(image, column, row, red, green, blue);
    }
  }
}

function strokeRect(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
): void {
  drawLine(image, x, y, x + width - 1, y, red, green, blue);
  drawLine(image, x, y, x, y + height - 1, red, green, blue);
  drawLine(image, x + width - 1, y, x + width - 1, y + height - 1, red, green, blue);
  drawLine(image, x, y + height - 1, x + width - 1, y + height - 1, red, green, blue);
}

function drawLine(
  image: PNG,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  red: number,
  green: number,
  blue: number,
): void {
  let x = startX;
  let y = startY;
  const deltaX = Math.abs(endX - startX);
  const deltaY = -Math.abs(endY - startY);
  const stepX = startX < endX ? 1 : -1;
  const stepY = startY < endY ? 1 : -1;
  let error = deltaX + deltaY;

  while (true) {
    setPixel(image, x, y, red, green, blue);
    if (x === endX && y === endY) {
      return;
    }

    const doubleError = error * 2;
    if (doubleError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubleError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

function setPixel(image: PNG, x: number, y: number, red: number, green: number, blue: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }

  const index = (image.width * y + x) << 2;
  image.data[index] = red;
  image.data[index + 1] = green;
  image.data[index + 2] = blue;
  image.data[index + 3] = 255;
}
