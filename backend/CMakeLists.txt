cmake_minimum_required(VERSION 3.16)
project(threatscope_backend CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Build type defaults ──────────────────────────────────────────────────────
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ── Compiler flags ───────────────────────────────────────────────────────────
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG -march=native")
set(CMAKE_CXX_FLAGS         "-Wall -Wextra -Wpedantic")

# ── Find Drogon ──────────────────────────────────────────────────────────────
find_package(Drogon REQUIRED)

# ── Source files ─────────────────────────────────────────────────────────────
set(SOURCES
    main.cpp
    # attack_generator and stats_tracker are header-only
)

add_executable(threatscope ${SOURCES})

target_link_libraries(threatscope
    PRIVATE
        Drogon::Drogon
)

target_include_directories(threatscope
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
)

# ── Create logs directory ────────────────────────────────────────────────────
add_custom_command(TARGET threatscope POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
        ${CMAKE_BINARY_DIR}/logs
    COMMENT "Creating logs directory"
)

# ── Install ──────────────────────────────────────────────────────────────────
install(TARGETS threatscope DESTINATION bin)

message(STATUS "ThreatScope Backend — build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Hardware threads detected: ${CMAKE_THREAD_LIBS_INIT}")
