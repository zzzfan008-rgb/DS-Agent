import type { Metadata } from 'next';
import { ProductImportView } from '@/components/products/ProductImportView';
import { ForbiddenState } from '@/components/states/ForbiddenState';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '导入商品' };
export const dynamic = 'force-dynamic';

export default async function ProductImportPage() {
  const guard = await guardPage(PERMISSIONS.productImport, '商品导入（product.import）');
  if (!guard.ok) {
    return guard.node ?? <ForbiddenState requiredPermission="商品导入（product.import）" />;
  }
  return <ProductImportView />;
}
