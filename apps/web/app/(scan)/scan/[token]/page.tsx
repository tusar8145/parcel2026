import ScanPhone from "@/features/scan/ScanPhone";

type Props = { params: Promise<{ token: string }> };

/** /scan/<token>: opened on a phone from the QR code or link in the "Scan with phone" modal. */
export default async function Page({ params }: Props) {
  const { token } = await params;
  return <ScanPhone token={token} />;
}
