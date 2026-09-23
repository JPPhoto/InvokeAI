"""Scoped cleanup of intermediate images and videos."""

from typing import Literal, Optional

from fastapi import APIRouter, Body, HTTPException, Path, Query, Response, status

from invokeai.app.api.auth_dependencies import CurrentUserOrDefault
from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.intermediates.intermediates_base import IntermediatesCaller
from invokeai.app.services.intermediates.intermediates_common import (
    IntermediatesBrowserHoldRequest,
    IntermediatesIdempotencyConflictError,
    IntermediatesOperation,
    IntermediatesOperationNotFoundError,
    IntermediatesOperationRequest,
    IntermediatesPreview,
    IntermediatesPreviewNotFoundError,
    IntermediatesPreviewRequest,
    IntermediatesScopeForbiddenError,
    IntermediatesScopeInvalidError,
    IntermediatesSummary,
    IntermediatesSummarySort,
    IntermediatesUnavailableError,
)
from invokeai.app.services.shared.pagination import MAX_PAGE_SIZE

intermediates_router = APIRouter(prefix="/v1/intermediates", tags=["intermediates"])


@intermediates_router.put("/holds/{lease_id}", status_code=status.HTTP_204_NO_CONTENT)
def replace_intermediates_browser_hold(
    current_user: CurrentUserOrDefault,
    request: IntermediatesBrowserHoldRequest,
    lease_id: str = Path(min_length=1, max_length=64),
) -> Response:
    """Protect names still held by this account's open browser editor, including undo state."""
    ApiDependencies.invoker.services.intermediates.replace_browser_hold(_caller(current_user), lease_id, request)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@intermediates_router.delete("/holds/{lease_id}", status_code=status.HTTP_204_NO_CONTENT)
def release_intermediates_browser_hold(
    current_user: CurrentUserOrDefault,
    lease_id: str = Path(min_length=1, max_length=64),
) -> Response:
    ApiDependencies.invoker.services.intermediates.release_browser_hold(_caller(current_user), lease_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _caller(current_user: CurrentUserOrDefault) -> IntermediatesCaller:
    return IntermediatesCaller(user_id=current_user.user_id, is_admin=current_user.is_admin)


def _translate(error: Exception) -> HTTPException:
    if isinstance(error, IntermediatesScopeForbiddenError):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error))
    if isinstance(error, IntermediatesScopeInvalidError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    if isinstance(error, (IntermediatesPreviewNotFoundError, IntermediatesOperationNotFoundError)):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error) or "Not found")
    if isinstance(error, (IntermediatesIdempotencyConflictError, IntermediatesUnavailableError)):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))
    raise error


@intermediates_router.get("/summary", operation_id="get_intermediates_summary", response_model=IntermediatesSummary)
def get_intermediates_summary(
    current_user: CurrentUserOrDefault,
    owner_id: Optional[str] = Query(
        default=None, min_length=1, max_length=255, description="Admins only: restrict rows to one account"
    ),
    project_id: Optional[str] = Query(default=None, min_length=1, max_length=255),
    search: Optional[str] = Query(default=None, max_length=200, description="Project (and, for admins, owner) filter"),
    sort: IntermediatesSummarySort = Query(default="reclaimable_bytes"),
    order: Literal["asc", "desc"] = Query(default="desc"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
) -> IntermediatesSummary:
    """Per-project intermediates with what a cleanup could reclaim. Non-admins see their own rows."""
    try:
        return ApiDependencies.invoker.services.intermediates.get_summary(
            _caller(current_user),
            owner_id=owner_id,
            search=search,
            sort=sort,
            descending=order == "desc",
            offset=offset,
            limit=limit,
            project_id=project_id,
        )
    except IntermediatesScopeForbiddenError as error:
        raise _translate(error)


@intermediates_router.post(
    "/previews",
    operation_id="create_intermediates_preview",
    response_model=IntermediatesPreview,
    status_code=status.HTTP_201_CREATED,
)
def create_intermediates_preview(
    current_user: CurrentUserOrDefault,
    request: IntermediatesPreviewRequest = Body(description="What to clear and how"),
) -> IntermediatesPreview:
    """Freezes the targets a cleanup would act on and reports its impact. Previews expire unused."""
    try:
        return ApiDependencies.invoker.services.intermediates.create_preview(request, _caller(current_user))
    except (IntermediatesScopeForbiddenError, IntermediatesScopeInvalidError, IntermediatesUnavailableError) as error:
        raise _translate(error)


@intermediates_router.post(
    "/operations",
    operation_id="start_intermediates_operation",
    response_model=IntermediatesOperation,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_intermediates_operation(
    current_user: CurrentUserOrDefault,
    request: IntermediatesOperationRequest = Body(description="The confirmed preview"),
) -> IntermediatesOperation:
    """Starts the cleanup a preview described. Repeating a request with its idempotency key returns the same operation."""
    try:
        return ApiDependencies.invoker.services.intermediates.start_operation(request, _caller(current_user))
    except (
        IntermediatesPreviewNotFoundError,
        IntermediatesIdempotencyConflictError,
        IntermediatesUnavailableError,
    ) as error:
        raise _translate(error)


@intermediates_router.get(
    "/operations/{operation_id}", operation_id="get_intermediates_operation", response_model=IntermediatesOperation
)
def get_intermediates_operation(
    current_user: CurrentUserOrDefault,
    operation_id: str = Path(min_length=1, max_length=64),
) -> IntermediatesOperation:
    try:
        return ApiDependencies.invoker.services.intermediates.get_operation(operation_id, _caller(current_user))
    except IntermediatesOperationNotFoundError as error:
        raise _translate(error)


@intermediates_router.post(
    "/operations/{operation_id}/retry",
    operation_id="retry_intermediates_operation",
    response_model=IntermediatesOperation,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_intermediates_operation(
    current_user: CurrentUserOrDefault,
    operation_id: str = Path(min_length=1, max_length=64),
) -> IntermediatesOperation:
    """Retries exactly the targets a finished operation left unresolved, as a new operation."""
    try:
        return ApiDependencies.invoker.services.intermediates.retry_operation(operation_id, _caller(current_user))
    except (
        IntermediatesOperationNotFoundError,
        IntermediatesScopeForbiddenError,
        IntermediatesUnavailableError,
    ) as error:
        raise _translate(error)
