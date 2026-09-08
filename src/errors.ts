export class ShipperError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ShipperError";
  }
}
