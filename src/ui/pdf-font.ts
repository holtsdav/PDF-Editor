import fontBytes from '../../assets/fonts/NotoSans-Regular.ttf';

import serif from '../../assets/fonts/NotoSerif-Regular.ttf';
import mono from '../../assets/fonts/NotoSansMono-Regular.ttf';
import { fontFaces } from '../pdf/text-format';

const fonts = new WeakMap<Document, { faces: FontFace[]; users: number }>();

/** Match the on-page editor to the font embedded in saved appearances. */
export function usePdfFont(doc: Document): () => void {
  let entry = fonts.get(doc);
  if (!entry) {
    const faces = ([['sans', fontBytes], ['serif', serif], ['mono', mono]] as const).map(([family, bytes]) => new doc.defaultView!.FontFace(fontFaces[family], bytes.slice().buffer as ArrayBuffer));
    entry = { faces, users: 0 }; fonts.set(doc, entry);
  }
  const shared = entry; shared.users++;
  for (const face of shared.faces) void face.load().then(() => { if (shared.users > 0) doc.fonts.add(face); }).catch(() => {});
  return () => { if (--shared.users === 0) for (const face of shared.faces) doc.fonts.delete(face); };
}
