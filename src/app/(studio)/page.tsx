import { Composer } from "@/components/dashboard/Composer";
import { RecentGenerations } from "@/components/dashboard/RecentGenerations";
import { GetStarted } from "@/components/dashboard/GetStarted";
import { FeaturedRow } from "@/components/dashboard/FeaturedRow";
import { TemplatesRow } from "@/components/dashboard/TemplatesRow";
import { ToolGrid } from "@/components/dashboard/ToolGrid";
import { ExamplesGallery } from "@/components/dashboard/ExamplesGallery";
import { ShowcaseRail } from "@/components/dashboard/ShowcaseRail";
import { DEMO } from "@/lib/demo/config";

export default function HomePage() {
  return (
    <>
      <div className="relative isolate xl:pr-[248px] 2xl:pr-[288px]">
        {/* The hero runs a little wider than the sections below it. */}
        <div className="mx-auto max-w-[1560px] px-3 pt-3 sm:px-4 sm:pt-4">
          <Composer />
        </div>
        <div className="mx-auto max-w-[1520px] space-y-14 px-4 pb-36 pt-12 sm:px-6 lg:space-y-20 lg:px-8 lg:pt-16">
          <RecentGenerations />
          {/* The live demo has nothing to set up. */}
          {DEMO ? null : <GetStarted />}
          <FeaturedRow />
          <TemplatesRow />
          <ToolGrid />
          <ExamplesGallery />
        </div>
        <div aria-hidden="true" className="scroll-fade pointer-events-none sticky bottom-0 z-10 -mt-28 h-28 sm:-mt-32 sm:h-32" />
      </div>
      <ShowcaseRail />
    </>
  );
}
