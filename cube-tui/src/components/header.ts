// cube-tui/src/components/header.ts
import type { Component } from "@earendil-works/pi-tui";
import { Banner } from "./banner.js";
import { InfoBox, type InfoBoxContent } from "./info-box.js";

export class Header implements Component {
  invalidate = () => {};

  private banner: Banner;
  private infoBox: InfoBox;

  constructor(info?: InfoBoxContent) {
    this.banner = new Banner();
    this.infoBox = new InfoBox("WorkSpace Information", info);
  }

  getBanner(): Banner {
    return this.banner;
  }

  getInfoBox(): InfoBox {
    return this.infoBox;
  }

  setInfo(info: InfoBoxContent) {
    this.infoBox.setInfo(info);
  }

  render(width: number): string[] {
    const bannerLines = this.banner.render(width);
    const infoBoxLines = this.infoBox.render(width);
    return [...bannerLines, "", ...infoBoxLines];
  }
}
