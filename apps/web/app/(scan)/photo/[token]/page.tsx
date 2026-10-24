import PhotoLink from "@/features/scan/PhotoLink";

type Props = { params: Promise<{ token: string }> };

/** /photo/<token>: a one-photo link opened on a phone from a QR code (e.g. a settlement's payment receipt). */
export default async function Page({ params }: Props) {
  const { token } = await params;
  return <PhotoLink token={token} />;
}
