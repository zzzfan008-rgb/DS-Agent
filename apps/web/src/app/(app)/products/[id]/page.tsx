import type { Metadata } from 'next';
import { ProductDetailView } from '@/components/products/ProductDetailView';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '商品详情' };
export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardPage(PERMISSIONS.productRead, '商品读取（product.read）');
  if (!guard.ok) return guard.node;
  const { id } = await params;
  return <ProductDetailView productId={id} />;
}
