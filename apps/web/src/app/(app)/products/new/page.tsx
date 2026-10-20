import type { Metadata } from 'next';
import { ProductCreateView } from '@/components/products/ProductCreateView';
import { ForbiddenState } from '@/components/states/ForbiddenState';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '新建商品' };
export const dynamic = 'force-dynamic';

export default async function ProductCreatePage() {
  const guard = await guardPage(PERMISSIONS.productWrite, '商品写（product.write）');
  if (!guard.ok) {
    return guard.node ?? <ForbiddenState requiredPermission="商品写（product.write）" />;
  }
  return <ProductCreateView />;
}
