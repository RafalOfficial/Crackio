import { Archivo, Instrument_Serif } from "next/font/google";

/**
 * The showcase's ad typography, loaded only where the rail is: heavy condensed italic for the
 * sticker titles and callouts, and an editorial serif for the lines that should feel like film.
 */
export const adSans = Archivo({ variable: "--font-ad", subsets: ["latin"], axes: ["wdth"], style: ["normal", "italic"], display: "swap" });
export const adSerif = Instrument_Serif({ variable: "--font-ad-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"], display: "swap" });

export const AD_FONTS = `${adSans.variable} ${adSerif.variable}`;
