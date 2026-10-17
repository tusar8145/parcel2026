// Old panel URLs that moved. next.config.ts redirects them before routing; this group answers
// the same when the redirects aren't loaded (e.g. a dev server started before they were added).
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
