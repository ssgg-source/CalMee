"use client";

import { useSidebar } from "@/components/Sidebar/SidebarProvider";
import { useRouter } from "next/navigation"
import { openMeetingWorkspace } from '@/lib/meeting-window';




export const useNavigation = (meetingId: string, meetingTitle: string) => {
    const router = useRouter();
    const { setCurrentMeeting } = useSidebar();

    const handleNavigation = () => {
        setCurrentMeeting({ id: meetingId, title: meetingTitle });
        void openMeetingWorkspace(meetingId, url => router.push(url), { title: meetingTitle });
    };

    return handleNavigation;
};
