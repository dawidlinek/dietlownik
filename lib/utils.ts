import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- clsx ClassValue is recursively self-referential (ClassArray = ClassValue[]); cannot be made deeply readonly without forking the upstream type
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
