export function DashboardGreeting({ name }: { name: string }) {
  // Instrument Serif italic on "hello" is the brand's "warm moment" — one
  // word per surface, contrasting the otherwise dry Geist sans rest.
  return (
    <h1 className="text-2xl font-medium tracking-tight">
      <span className="font-serif italic font-normal">hello</span>, {name}
    </h1>
  );
}
