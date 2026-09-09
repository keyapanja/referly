import { Guide } from "@/components/guide";
import { readGuide } from "@/lib/guides";

export const dynamic = "force-static";
export const metadata = { title: "Guide" };

export default function MerchantGuidePage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Guide</h1>
          <p>How the platform works and how to run every process in it.</p>
        </div>
      </div>
      <Guide markdown={readGuide("merchant-guide")} />
    </>
  );
}
