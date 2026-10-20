import type { Metadata } from 'next';
import { ProductsView } from '@/components/products/ProductsView';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '商品库' };
export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const guard = await guardPage(PERMISSIONS.productRead, '商品读取（product.read）');
  if (!guard.ok) return guard.node;

  return (
    <ProductsView
      canWrite={guard.me.permissions.includes(PERMISSIONS.productWrite)}
      canImport={guard.me.permissions.includes(PERMISSIONS.productImport)}
    />
  );
}
