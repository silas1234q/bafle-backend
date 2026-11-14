import { Router } from "express";

import { localUser, requireUser } from "../middleware/auth.js";
import { listUserTickets } from "../services/tickets.js";

/**
 * The buyer side of a raffle: tickets this user holds.
 *
 * Router-wide auth and a bare `GET /` meaning "mine", matching ordersRouter
 * and addressesRouter. Nothing here is addressable by anyone else, so there
 * is no id to guard and no ownership check beyond the session.
 */
export const ticketsRouter = Router();

ticketsRouter.use(requireUser);

ticketsRouter.get("/", async (req, res) => {
  const user = localUser(req);

  res.json(await listUserTickets(user.id));
});
