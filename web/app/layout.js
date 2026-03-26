import './globals.css';

export const metadata = {
  title: 'Nocturne Memory',
  description: 'Nocturne structured memory management',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap"
        />
      </head>
      <body className="bg-[#0d0d10] text-zinc-300" style={{ fontFamily: "'Fira Sans', system-ui, -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
