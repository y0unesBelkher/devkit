import { Injectable, inject } from '@angular/core';
import type { ApiResult, FileOpRequest, FilePreview, ListFilesResponse } from '@devkit/shared';
import { Daemon } from './daemon';

/** The daemon's file API; every operation runs as the WSL project user. */
@Injectable({ providedIn: 'root' })
export class FilesApi {
  private readonly daemon = inject(Daemon);

  list(path?: string): Promise<ApiResult<ListFilesResponse>> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.daemon.api<ListFilesResponse>({ method: 'GET', path: `/api/files${query}` });
  }

  preview(path: string): Promise<ApiResult<FilePreview>> {
    return this.daemon.api<FilePreview>({ method: 'GET', path: `/api/files/preview?path=${encodeURIComponent(path)}` });
  }

  op(op: 'mkdir' | 'touch' | 'rename' | 'delete' | 'chmod', body: FileOpRequest): Promise<ApiResult<unknown>> {
    return this.daemon.api({ method: 'POST', path: `/api/files/${op}`, body });
  }
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
