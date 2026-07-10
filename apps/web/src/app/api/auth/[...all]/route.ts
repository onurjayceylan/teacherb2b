// better-auth uç noktaları (sign-up/sign-in/get-session/...): tek catch-all handler.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
