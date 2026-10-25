import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, fetchProfile } from "@/lib/api";
import ProfileView from "./ProfileView";

// 내 정보: 사진·부르는 이름·한 줄 소개·하는 일·업무 키워드 (인사 정보는 보기만)
export default async function ProfilePage() {
  const cookieHeader = (await headers()).get("cookie");
  let profile;
  try {
    profile = await fetchProfile(cookieHeader);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login?reason=expired&next=/profile");
    throw error;
  }
  return <ProfileView initial={profile} />;
}
