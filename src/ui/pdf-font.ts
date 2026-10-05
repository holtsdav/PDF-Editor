import fontBytes from '../../assets/fonts/NotoSans-Regular.ttf';

const fonts = new WeakMap<Document, { face: FontFace; users: number }>();

/** Match the on-page editor to the font embedded in saved appearances. */
export function usePdfFont(doc: Document): () => void {
  let entry = fonts.get(doc);
  if (!entry) {
    const face = new doc.defaultView!.FontFace('PDF Form Studio Text', fontBytes.slice().buffer as ArrayBuffer);
    entry = { face, users: 0 }; fonts.set(doc, entry);
  }
  const shared = entry; shared.users++;
  void shared.face.load().then(() => { if (shared.users > 0) doc.fonts.add(shared.face); }).catch(() => {});
  return () => { if (--shared.users === 0) doc.fonts.delete(shared.face); };
}
