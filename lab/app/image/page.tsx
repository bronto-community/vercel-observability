import Image from "next/image";
import gradient from "../../public/gradient.png";

export default function ImagePage() {
  return (
    <main>
      <h1>Image Optimization</h1>
      <p>This image is served through <code>/_next/image</code>, which triggers a transformation.</p>
      <Image src={gradient} alt="A colour gradient" width={200} sizes="200px" />
    </main>
  );
}
