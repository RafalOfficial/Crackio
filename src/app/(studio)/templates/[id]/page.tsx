import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TEMPLATES, templateById } from "@/lib/templates/library";
import { TemplateStudio } from "@/components/templates/TemplateStudio";

export function generateStaticParams() {
  return TEMPLATES.map((t) => ({ id: t.id }));
}

export async function generateMetadata({ params }: PageProps<"/templates/[id]">): Promise<Metadata> {
  const t = templateById((await params).id);
  return t ? { title: `${t.title} · Templates`, description: t.line } : { title: "Templates" };
}

// The template is read inside a boundary, so a navigation shows its frame at once.
export default function Page({ params }: PageProps<"/templates/[id]">) {
  return (
    <Suspense fallback={<div className="mx-auto h-[70vh] max-w-[1440px] px-4 pt-6 sm:px-6 lg:px-10 lg:pt-8"><div className="skeleton h-full rounded-panel" /></div>}>
      <Studio params={params} />
    </Suspense>
  );
}

async function Studio({ params }: { params: PageProps<"/templates/[id]">["params"] }) {
  const { id } = await params;
  if (!templateById(id)) notFound();
  return <TemplateStudio id={id} />;
}
