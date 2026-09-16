import type { InfiniteData } from '@tanstack/react-query';

import {
  getLibraryWorkflowRecord,
  listLibraryWorkflows,
  type ListWorkflowsParams,
  type WorkflowLibraryPage,
  type WorkflowRecordDTO,
} from './api';

export const savedWorkflowDetailQueryOptions = (workflowId: string) => ({
  queryKey: ['workflow', 'call-saved', 'detail', workflowId] as const,
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkflowRecordDTO> =>
    getLibraryWorkflowRecord(workflowId, signal),
  staleTime: 30_000,
});

export const savedWorkflowPickerQueryOptions = (params: ListWorkflowsParams) => ({
  queryKey: ['workflow', 'call-saved', 'picker', params] as const,
  queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }): Promise<WorkflowLibraryPage> =>
    listLibraryWorkflows({ ...params, page: pageParam, signal }),
  initialPageParam: 0,
  getNextPageParam: (lastPage: WorkflowLibraryPage): number | undefined =>
    lastPage.page + 1 < lastPage.pages ? lastPage.page + 1 : undefined,
});

export const getWorkflowPagesItems = (
  data: InfiniteData<WorkflowLibraryPage, unknown> | undefined
): WorkflowLibraryPage['items'] => data?.pages.flatMap((page) => page.items) ?? [];
