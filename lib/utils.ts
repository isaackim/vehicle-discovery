import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Returns true if mileage is in the VIO "green" range (15–1000 miles). */
export function isVioGreen(mileage: number): boolean {
  return mileage >= 15 && mileage <= 1000;
}
