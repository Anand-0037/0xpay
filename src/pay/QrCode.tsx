import { useMemo } from 'react'
import qrcode from './vendor/qrcode.mjs'

export default function QrCode({ value }: { value: string }) {
  const qr = useMemo(() => {
    const instance = qrcode(0, 'M')
    instance.addData(value)
    instance.make()
    return instance
  }, [value])
  const size = qr.getModuleCount()
  const cells = []
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    if (qr.isDark(row, column)) cells.push(<rect x={column + 4} y={row + 4} width="1" height="1" key={`${row}-${column}`} />)
  }
  return <svg className="px-qr" role="img" aria-label="QR code for the payment link" viewBox={`0 0 ${size + 8} ${size + 8}`} xmlns="http://www.w3.org/2000/svg"><rect width={size + 8} height={size + 8} fill="#fff" /><g fill="#101410">{cells}</g></svg>
}
