import Image from "next/image";

export default function Home() {
  return (
    <main>
      <h1>{process.env.NEXT_PUBLIC_APP_NAME}</h1>
    </main>
  );
}

