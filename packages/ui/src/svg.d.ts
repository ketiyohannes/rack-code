/** SVG files are bundled as text by esbuild (see scripts/build-desktop.ts). */
declare module "*.svg" {
  const markup: string;
  export default markup;
}
