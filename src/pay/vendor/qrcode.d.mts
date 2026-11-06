/** Kazuhiko Arase, qrcode-generator 2.0.4, MIT. */
declare const qrcode: (version: number, correction: 'L' | 'M' | 'Q' | 'H') => {
  addData(value: string): void
  make(): void
  getModuleCount(): number
  isDark(row: number, column: number): boolean
}
export default qrcode
