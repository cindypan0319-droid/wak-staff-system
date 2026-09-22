import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: "/staff/daily-entry",
    permanent: false,
  },
});

export default function PlatformIncomeRedirectPage() {
  return null;
}
