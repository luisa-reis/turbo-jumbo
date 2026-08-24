import {coldStorageSite, localModelsSite} from '@/lib/storage/storage-instance';
import {NextResponse} from 'next/server';
import {lemonadeDir} from '@/lib/config';
import {scanModels} from '@/lib/models/models';
import {getModelsTableData} from '@/components/models/models-table';

export async function GET() {
  const coldModels = await scanModels(coldStorageSite);
  const localModels = await scanModels(localModelsSite, lemonadeDir);
  return NextResponse.json(getModelsTableData(localModels, coldModels));
}
