// The bundled libraries in shared/vendor/ and their versions, written down in one place.
// To move a library to a new version, put it in a new folder and change its name here. The few
// places that cannot read this file (the <script> tags of kaotori/ and kaokakushi/, the import
// at the top of pdf.js) are checked against it by `node tests/vendor-check.mjs`.
export const LIB = {
  pdfjs: "pdfjs-4.10.38",
  pdfLib: "pdf-lib-1.17.1",
  fontkit: "fontkit-1.1.1",
  harfbuzz: "harfbuzz-1.6.3",
  notoSansJp: "noto-sans-jp",
  heicTo: "heic-to-1.6.6",
  tesseract: "tesseract-7.0.0",
  qrcode: "qrcode-generator-2.0.4",
  mediapipe: "mediapipe-tasks-vision-1.2.0",
  mediapipeModels: "mediapipe-face-models",
  faceApi: "face-api-1.7.15",
  jszip: "jszip-3.10.2",
  mediabunny: "mediabunny-1.65.0",
};

// "pdfjs-4.10.38/pdf.min.mjs" → its full address.
export const vendorUrl = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

// The files each library needs, for the tools' registerOffline([...]) lists. A tool that loads a
// library only when it is used (pdf-lib when saving) still lists it, so that it works offline
// even if it was never used while online.
export const OFFLINE = {
  pdfjs: [`${LIB.pdfjs}/pdf.min.mjs`, `${LIB.pdfjs}/pdf.worker.min.mjs`].map(vendorUrl),
  pdfLib: [`${LIB.pdfLib}/pdf-lib.min.js`].map(vendorUrl),
  // Japanese text in PDFs (font-jp.js): fontkit, the font, and HarfBuzz to cut the font down.
  fontJp: [
    `${LIB.fontkit}/fontkit.umd.min.js`,
    `${LIB.harfbuzz}/harfbuzz-subset.wasm`,
    `${LIB.notoSansJp}/NotoSansJP-Regular.ttf`,
  ].map(vendorUrl),
  heic: [`${LIB.heicTo}/heic-to.min.js`].map(vendorUrl),
  qrcode: [`${LIB.qrcode}/qrcode.mjs`].map(vendorUrl),
  mediabunny: [`${LIB.mediabunny}/mediabunny.min.js`].map(vendorUrl),
  mediapipe: [`${LIB.mediapipe}/vision.js`, `${LIB.mediapipe}/wasm.js`].map(vendorUrl),
  faceDetector: [`${LIB.mediapipeModels}/face-detector.js`].map(vendorUrl),
  faceLandmarker: [`${LIB.mediapipeModels}/face-landmarker.js`].map(vendorUrl),
  selfieSegmenter: [`${LIB.mediapipeModels}/selfie-segmenter.js`].map(vendorUrl),
  faceApi: [`${LIB.faceApi}/face-api.js`, `${LIB.faceApi}/face-recognition-model.js`].map(vendorUrl),
  jszip: [`${LIB.jszip}/jszip.min.js`].map(vendorUrl),
};
