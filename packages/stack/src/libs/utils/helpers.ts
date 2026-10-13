import {WebResponse} from "@shared/types/web";
import {Response} from "express";

export function respond<T>(res: Response, statusCode: number, status: "success" | "error", message: string, data?: T): Response {
    const body: WebResponse<T> = {
        status,
        message,
        ...(data !== undefined ? { data } : {}),
    };

    return res.status(statusCode).json(body);
}
