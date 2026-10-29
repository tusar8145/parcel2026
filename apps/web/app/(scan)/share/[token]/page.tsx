import ShareFiles from "@/features/scan/ShareFiles";

type Props = { params: Promise<{ token: string }> };

/** /share/<token>: drop files that show in Courier Operations › Share files on the computer (QR code). */
export default async function Page({ params }: Props) {
  const { token } = await params;
  return <ShareFiles token={token} />;
}
