// Minimal declaration for the `citeproc` npm package (citeproc-js 1.4.63,
// the CommonJS snapshot Zotero bundles). Only the surface this app uses.
declare module "citeproc" {
  interface CslSys {
    retrieveLocale?: (lang: string) => string | undefined;
    retrieveItem?: (id: string) => unknown;
    getAbbreviations?: () => unknown;
  }
  interface CslEngine {
    addItems(items: unknown[]): void;
    updateItems(ids: string[]): void;
    makeBibliography(): { bibstart: string; bibend: string; entries: string[] } | undefined;
  }
  const CSL: {
    Engine: new (sys: CslSys, styleXml: string, lang?: string) => CslEngine;
  };
  export default CSL;
}
