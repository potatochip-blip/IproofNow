import type { ReactNode } from 'react';

export const metadata = {
  title: 'iProofNow API',
  description: 'iProofNow backend',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
