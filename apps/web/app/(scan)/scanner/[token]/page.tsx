import PhoneScanner from "@/features/scan/PhoneScanner";

type Props = { params: Promise<{ token: string }> };

/** /scanner/<token>: a phone opened from Courier Operations › Phone scanner (QR code or link) becomes that tab's barcode scanner. */
export default async function Page({ params }: Props) {
  const { token } = await params;
  return <PhoneScanner token={token} />;
}
