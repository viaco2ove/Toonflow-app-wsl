import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().optional(),
    ids: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    const { id, ids } = req.body;
    const targetIds = Array.from(
      new Set([
        ...(Array.isArray(ids) ? ids : []),
        ...(Number.isFinite(id) ? [id] : []),
      ]),
    ).filter((item) => Number.isFinite(item) && item > 0);

    if (targetIds.length === 0) {
      return res.status(400).send(error("未提供可删除的分镜ID"));
    }

    await u.db("t_assets").whereIn("id", targetIds).delete();
    res.status(200).send(
      success({
        message: "分镜删除成功",
        deletedCount: targetIds.length,
        deletedIds: targetIds,
      }),
    );
  },
);
