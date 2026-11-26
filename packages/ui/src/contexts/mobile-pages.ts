import { createContext, useContext } from 'react';

export type MobileDocumentLink = { directory: string; path: string; line?: number; column?: number };
export interface MobilePageActions {
  showDetails(open: boolean): void;
  openDocument(link: MobileDocumentLink): void;
}
export const MobilePageContext = createContext<MobilePageActions | null>(null);
export const useMobilePages = () => useContext(MobilePageContext);
