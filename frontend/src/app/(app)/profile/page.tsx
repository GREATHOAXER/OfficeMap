import type { Metadata } from "next";
import { headers } from "next/headers";
import { ApiError, fetchProfile } from "@/lib/api";
import { redirectToLogin } from "@/lib/expiredRedirect";
import ProfileView from "./ProfileView";

export const metadata: Metadata = { title: "내 정보 · Office Map" };

// 내 정보: 사진·부르는 이름·한 줄 소개·하는 일·업무 키워드 (인사 정보는 보기만)
export default async function ProfilePage() {
  const cookieHeader = (await headers()).get("cookie");
  let profile;
  try {
    profile = await fetchProfile(cookieHeader);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirectToLogin();
    throw error;
  }
  return <ProfileView initial={profile} />;
}
