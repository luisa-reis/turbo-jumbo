import {NextResponse} from 'next/server';
import {localModelsDir, coldStorageDir, lemonadeDir} from '@/lib/config';
import {scanModels} from '@/lib/models/models';
import {getModelsTableData} from '@/components/models/models-table';

export async function GET() {
  const coldModels = await scanModels(coldStorageDir);
  const localModels = await scanModels(localModelsDir, lemonadeDir);
  return NextResponse.json(getModelsTableData(localModels, coldModels));
}
