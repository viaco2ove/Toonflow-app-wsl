import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取厂商
export default router.post(
  "/",
  validateFields({
    userId: z.number(),
  }),
  async (req, res) => {
    const { userId } = req.body;

    const rows = await u.db("t_config").where("type", "video").where("userId", userId).select("manufacturer", "model", "id");
    const data = rows.map((item: any) => ({
      ...item,
      manufacturer: String(item?.manufacturer || "").trim() || "unknown",
    }));

    res.status(200).send(success(data));
  },
);
