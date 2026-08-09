import { Response } from "express";

interface Pagination {
  page: number;
  limit: number;
  total: number;
}

// Consistent success envelope across every endpoint, so the Angular
// frontend can rely on one response shape.
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  pagination?: Pagination
): Response {
  return res.status(statusCode).json({
    success: true,
    data,
    ...(pagination && {
      pagination: { ...pagination, totalPages: Math.ceil(pagination.total / pagination.limit) },
    }),
  });
}
