#!/bin/bash
PS3="Enter choice: "
echo "Choose a log level:"
select lvl in debug info warn; do echo "RESULT $lvl"; break; done
