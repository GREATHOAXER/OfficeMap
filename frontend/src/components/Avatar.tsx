import Image from "next/image";

/** 사람 동그라미: 내 정보 사진이 있으면 사진, 없으면 이름 끝 두 글자. 크기·모양은 감싸는 쪽 CSS가 정한다 */
export default function Avatar({
  name,
  photo,
  size = 36,
}: {
  name: string;
  photo: string | null | undefined;
  size?: number;
}) {
  if (!photo) return <>{name.slice(-2)}</>;
  // 사진은 API가 주는 작은 정사각형(320px)이라 Next 이미지 최적화는 쓰지 않는다
  return (
    <Image
      src={photo}
      alt=""
      width={size}
      height={size}
      unoptimized
      style={{ width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }}
    />
  );
}
